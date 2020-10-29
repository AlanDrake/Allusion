import React, { useState, useEffect, useCallback, useRef, useContext, useMemo } from 'react';
import { FixedSizeList } from 'react-window';
import { Observer, observer } from 'mobx-react-lite';

import StoreContext from '../../contexts/StoreContext';
import {
  ExternalAppMenuItems,
  FileViewerMenuItems,
  GridCell,
  ListCell,
  MissingFileMenuItems,
  MissingImageFallback,
} from './GalleryItem';
import { ClientFile } from '../../../entities/File';
import { IconSet } from 'components';
import { ContextMenu, SubMenu, Menu, MenuDivider } from 'components/menu';
import { throttle } from '../../utils';
import { Rectangle } from 'electron';
import ZoomableImage from './ZoomableImage';
import useSelectionCursor from '../../hooks/useSelectionCursor';
import { LayoutMenuItems, SortMenuItems } from '../Toolbar/ContentToolbar';
import useContextMenu from '../../hooks/useContextMenu';
import Placeholder from './Placeholder';
import { RendererMessenger } from 'src/Messaging';
import { DnDAttribute, DnDType } from '../Outliner/TagsPanel/DnD';
import UiStore from '../../stores/UiStore';
import { action, runInAction } from 'mobx';

const GridGallery = observer(
  ({ contentRect, select, lastSelectionIndex, showContextMenu }: ILayoutProps) => {
    const { fileStore, uiStore } = useContext(StoreContext);
    const { fileList } = fileStore;
    const [minSize, maxSize] = useMemo(() => getThumbnailSize(uiStore.thumbnailSize), [
      uiStore.thumbnailSize,
    ]);
    const [[numColumns, cellSize], setDimensions] = useState([0, 0]);

    useEffect(() => {
      const timeoutID = setTimeout(() => {
        setDimensions(get_column_layout(contentRect.width, minSize, maxSize));
      }, 50);

      return () => {
        clearTimeout(timeoutID);
      };
    }, [contentRect.width, maxSize, minSize]);

    const numRows = useMemo(() => (numColumns > 0 ? Math.ceil(fileList.length / numColumns) : 0), [
      fileList.length,
      numColumns,
    ]);

    const ref = useRef<FixedSizeList>(null);
    const innerRef = useRef<HTMLElement>(null);
    const topOffset = useRef(0);
    const observer = useRef(
      new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting && e.intersectionRect.y === topOffset.current) {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              const rowIndex = parseInt(e.target.getAttribute('aria-rowindex')!) - 1;
              const index = rowIndex * e.target.childElementCount;
              uiStore.setFirstItem(index);
              break;
            }
          }
        },
        { threshold: [0, 1] },
      ),
    );

    useEffect(() => {
      if (innerRef.current !== null) {
        // TODO: Use resize observer on toolbar to get offset.
        topOffset.current = innerRef.current.getBoundingClientRect().y;
        const children = innerRef.current.children;
        for (let i = 0; i < children.length; i++) {
          observer.current.observe(children[i]);
        }
      }

      () => observer.current.disconnect();
    }, []);

    useEffect(() => {
      if (innerRef.current !== null) {
        innerRef.current.style.setProperty('--thumbnail-size', cellSize - PADDING + 'px');
      }
    }, [cellSize]);

    const handleScrollTo = useCallback(
      (i: number) => {
        if (ref.current) {
          ref.current.scrollToItem(Math.floor(i / numColumns));
        }
      },
      [numColumns],
    );

    // force an update with an observable obj since no rerender is triggered when a Ref value updates (lastSelectionIndex)
    const forceUpdateObj =
      uiStore.fileSelection.size === 0 ? null : uiStore.getFirstSelectedFileId();

    // Scroll to a file when selecting it
    const latestSelectedFile =
      typeof lastSelectionIndex.current === 'number' &&
      lastSelectionIndex.current < fileList.length &&
      fileList[lastSelectionIndex.current].id;
    useEffect(() => {
      if (latestSelectedFile) {
        const index = fileStore.getIndex(latestSelectedFile);
        if (index !== undefined && index >= 0) {
          handleScrollTo(index);
        }
      }
    }, [latestSelectedFile, handleScrollTo, fileStore, forceUpdateObj]);

    // Arrow keys up/down for selecting image in next row
    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        // Up and down cursor keys are used in the tag selector list, so ignore these events when it is open
        if (lastSelectionIndex.current === undefined) {
          return;
        }

        let index = lastSelectionIndex.current;
        if (e.key === 'ArrowUp' && index >= numColumns) {
          index -= numColumns;
        } else if (
          e.key === 'ArrowDown' &&
          index < fileList.length - 1 &&
          index < fileList.length + numColumns - 1
        ) {
          index = Math.min(index + numColumns, fileList.length - 1);
        } else {
          return;
        }
        select(fileList[index], e.ctrlKey || e.metaKey, e.shiftKey);
      };

      const throttledKeyDown = throttle(onKeyDown, 50);
      window.addEventListener('keydown', throttledKeyDown);
      return () => window.removeEventListener('keydown', throttledKeyDown);
    }, [fileList, uiStore, numColumns, select, lastSelectionIndex]);

    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        const index = getGridItemIndex(e, numColumns, (t) => t.matches('[role="gridcell"] *'));
        if (index !== undefined) {
          runInAction(() => select(fileList[index], e.ctrlKey || e.metaKey, e.shiftKey));
        }
      },
      [fileList, numColumns, select],
    );

    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        const index = getGridItemIndex(e, numColumns, (t) => t.matches('[role="gridcell"] *'));
        if (index === undefined) {
          return;
        }
        runInAction(() => {
          uiStore.selectFile(fileList[index], true);
          uiStore.enableSlideMode();
        });
      },
      [fileList, numColumns, uiStore],
    );

    const handleContextMenu = useCallback(
      (e: React.MouseEvent) => {
        const index = getGridItemIndex(e, numColumns, (t) => t.matches('[role="gridcell"] *'));
        if (index === undefined) {
          return;
        }
        runInAction(() => {
          const file = fileList[index];
          showContextMenu(e.clientX, e.clientY, [
            file.isBroken ? <MissingFileMenuItems /> : <FileViewerMenuItems file={file} />,
            file.isBroken ? <></> : <ExternalAppMenuItems path={file.absolutePath} />,
          ]);
        });
      },
      [fileList, numColumns, showContextMenu],
    );

    const handleDragStart = useCallback(
      (e: React.DragEvent) => {
        const index = getGridItemIndex(e, numColumns, (t) => t.matches('.thumbnail'));
        onDragStart(e, index, uiStore, fileList);
      },
      [fileList, numColumns, uiStore],
    );

    const handleDrop = useCallback(
      (e: React.DragEvent<HTMLElement>) => {
        if (e.dataTransfer.types.includes(DnDType)) {
          const index = getGridItemIndex(e, numColumns, (t) => t.matches('.thumbnail'));
          onDrop(e, index, uiStore, fileList);
        }
      },
      [fileList, numColumns, uiStore],
    );

    const Row = useCallback(
      ({ index, style, data, isScrolling }) => (
        <Observer>
          {() => {
            const offset = index * numColumns;
            return (
              <div
                ref={(el) => {
                  if (el !== null) {
                    observer.current.observe(el);
                  }
                }}
                role="row"
                aria-rowindex={index + 1}
                style={style}
              >
                {data.slice(offset, offset + numColumns).map((file: ClientFile, i: number) => (
                  <GridCell suspended={isScrolling} colIndex={i + 1} key={file.id} file={file} />
                ))}
              </div>
            );
          }}
        </Observer>
      ),
      [numColumns],
    );

    return (
      <div
        className="grid"
        role="grid"
        aria-rowcount={numRows}
        aria-colcount={numColumns}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <FixedSizeList
          useIsScrolling
          height={contentRect.height}
          width={contentRect.width}
          itemSize={cellSize}
          itemCount={numRows}
          itemData={fileList}
          itemKey={getItemKey}
          overscanCount={2}
          children={Row}
          initialScrollOffset={Math.round(uiStore.firstItem / numColumns) * cellSize || 0} // || 0 for initial load
          ref={ref}
          innerRef={innerRef}
        />
      </div>
    );
  },
);

const ListGallery = observer(
  ({ contentRect, select, lastSelectionIndex, showContextMenu }: ILayoutProps) => {
    const { fileStore, uiStore } = useContext(StoreContext);
    const { fileList } = fileStore;
    const cellSize = useMemo(() => getThumbnailSize(uiStore.thumbnailSize)[1], [
      uiStore.thumbnailSize,
    ]);
    const ref = useRef<FixedSizeList>(null);
    const innerRef = useRef<HTMLElement>(null);
    const topOffset = useRef(0);
    const observer = useRef(
      new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting && e.intersectionRect.y === topOffset.current) {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              const rowIndex = e.target.getAttribute('aria-rowindex')!;
              uiStore.setFirstItem(parseInt(rowIndex) - 1);
              break;
            }
          }
        },
        { threshold: [0, 1] },
      ),
    );

    useEffect(() => {
      if (innerRef.current !== null) {
        // TODO: Use resize observer on toolbar to get offset.
        topOffset.current = innerRef.current.getBoundingClientRect().y;
        const children = innerRef.current.children;
        for (let i = 0; i < children.length; i++) {
          observer.current.observe(children[i]);
        }
      }

      () => observer.current.disconnect();
    }, []);

    const handleScrollTo = useCallback((i: number) => {
      if (ref.current) {
        ref.current.scrollToItem(i);
      }
    }, []);

    // force an update with an observable obj since no rerender is triggered when a Ref value updates (lastSelectionIndex)
    const forceUpdateObj =
      uiStore.fileSelection.size === 0 ? null : uiStore.getFirstSelectedFileId();

    // Scroll to a file when selecting it
    const latestSelectedFile =
      lastSelectionIndex.current &&
      lastSelectionIndex.current < fileList.length &&
      fileList[lastSelectionIndex.current].id;
    useEffect(() => {
      if (latestSelectedFile) {
        const index = fileStore.getIndex(latestSelectedFile);
        if (latestSelectedFile && index !== undefined && index >= 0) {
          handleScrollTo(index);
        }
      }
    }, [latestSelectedFile, handleScrollTo, fileList, forceUpdateObj, fileStore]);

    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        const index = getListItemIndex(e, (t) => t.matches('.thumbnail'));
        if (index !== undefined) {
          runInAction(() => select(fileList[index], e.ctrlKey || e.metaKey, e.shiftKey));
        }
      },
      [fileList, select],
    );

    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        const index = getListItemIndex(e, (t) => t.matches('.thumbnail'));
        if (index === undefined) {
          return;
        }
        runInAction(() => {
          uiStore.selectFile(fileList[index], true);
          uiStore.enableSlideMode();
        });
      },
      [fileList, uiStore],
    );

    const handleContextMenu = useCallback(
      (e: React.MouseEvent) => {
        const index = getListItemIndex(e, () => true);
        if (index === undefined) {
          return;
        }
        runInAction(() => {
          const file = fileList[index];
          showContextMenu(e.clientX, e.clientY, [
            file.isBroken ? <MissingFileMenuItems /> : <FileViewerMenuItems file={file} />,
            file.isBroken ? <></> : <ExternalAppMenuItems path={file.absolutePath} />,
          ]);
        });
      },
      [fileList, showContextMenu],
    );

    const handleDragStart = useCallback(
      (e: React.DragEvent) => {
        const index = getListItemIndex(e, (t) => t.matches('.thumbnail'));
        onDragStart(e, index, uiStore, fileList);
      },
      [fileList, uiStore],
    );

    const handleDrop = useCallback(
      (e: React.DragEvent<HTMLElement>) => {
        if (e.dataTransfer.types.includes(DnDType)) {
          const index = getListItemIndex(e, (t) => t.matches('.thumbnail'));
          onDrop(e, index, uiStore, fileList);
        }
      },
      [fileList, uiStore],
    );

    const Row = useCallback(
      ({ index, style, data, isScrolling }) => (
        <Observer>
          {() => {
            const file = data[index];
            return (
              <div
                ref={(el) => {
                  if (el !== null) {
                    observer.current.observe(el);
                  }
                }}
                role="row"
                aria-rowindex={index + 1}
                style={style}
              >
                <ListCell suspended={isScrolling} file={file} />
              </div>
            );
          }}
        </Observer>
      ),
      [],
    );

    return (
      <div
        className="list"
        role="grid"
        aria-rowcount={fileList.length}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onDragStart={handleDragStart}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <FixedSizeList
          useIsScrolling
          height={contentRect.height}
          width={contentRect.width}
          itemSize={cellSize}
          itemCount={fileList.length}
          itemData={fileList}
          itemKey={getItemKey}
          overscanCount={2}
          children={Row}
          initialScrollOffset={uiStore.firstItem * cellSize}
          ref={ref}
          innerRef={innerRef}
        />
      </div>
    );
  },
);

export const MasonryGallery = observer(({}: ILayoutProps) => {
  const Styles: any = {
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '65%',
  };

  return (
    <div style={Styles}>
      <span className="custom-icon-64" style={{ marginBottom: '1rem' }}>
        {IconSet.DB_ERROR}
      </span>
      <p>This view is currently not supported</p>
    </div>
  );
});

const SlideGallery = observer(({ contentRect }: { contentRect: Rectangle }) => {
  const { fileStore, uiStore } = useContext(StoreContext);
  const { fileList } = fileStore;
  // Go to the first selected image on load
  useEffect(() => {
    if (uiStore.firstSelectedFile !== undefined) {
      uiStore.setFirstItem(fileStore.getIndex(uiStore.firstSelectedFile.id));
    }
  }, [fileStore, uiStore]);

  // Go back to previous view when pressing the back button (mouse button 5)
  useEffect(() => {
    // Push a dummy state, so that a pop-state event can be activated
    history.pushState(null, document.title, location.href);
    const popStateHandler = uiStore.disableSlideMode;
    window.addEventListener('popstate', popStateHandler);
    return () => window.removeEventListener('popstate', popStateHandler);
  }, [uiStore.disableSlideMode]);

  // Automatically select the active image, so it is shown in the inspector
  useEffect(() => {
    if (uiStore.firstItem < fileList.length) {
      uiStore.selectFile(fileList[uiStore.firstItem], true);
    }
  }, [fileList, uiStore]);

  const decrImgIndex = useCallback(() => uiStore.setFirstItem(Math.max(0, uiStore.firstItem - 1)), [
    uiStore,
  ]);
  const incrImgIndex = useCallback(
    () => uiStore.setFirstItem(Math.min(uiStore.firstItem + 1, fileList.length - 1)),
    [uiStore, fileList.length],
  );

  // Detect left/right arrow keys to scroll between images
  const handleUserKeyPress = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        decrImgIndex();
      } else if (event.key === 'ArrowRight') {
        incrImgIndex();
      } else if (event.key === 'Escape' || event.key === 'Backspace') {
        uiStore.disableSlideMode();
      }
    },
    [incrImgIndex, decrImgIndex, uiStore],
  );

  // Detect scroll wheel to scroll between images
  const handleUserWheel = useCallback(
    (event: WheelEvent) => {
      if (event.ctrlKey) {
        return;
      }
      event.preventDefault();

      if (event.deltaY > 0) {
        decrImgIndex();
      } else if (event.deltaY < 0) {
        incrImgIndex();
      }
    },
    [incrImgIndex, decrImgIndex],
  );

  // Set up event listeners
  useEffect(() => {
    window.addEventListener('keydown', handleUserKeyPress);
    // window.addEventListener('wheel', handleUserWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', handleUserKeyPress);
      // window.removeEventListener('wheel', handleUserWheel);
    };
  }, [handleUserKeyPress, handleUserWheel]);

  // Preload next and previous image for better UX
  useEffect(() => {
    if (uiStore.firstItem + 1 < fileList.length) {
      const nextImg = new Image();
      nextImg.src = fileList[uiStore.firstItem + 1].absolutePath;
    }
    if (uiStore.firstItem - 1 >= 0) {
      const prevImg = new Image();
      prevImg.src = fileList[uiStore.firstItem - 1].absolutePath;
    }
  }, [fileList, uiStore.firstItem]);

  if (uiStore.firstItem >= fileList.length) {
    return <p>No files available</p>;
  }

  const file = fileList[uiStore.firstItem];

  return file.isBroken ? (
    <MissingImageFallback
      style={{
        width: `${contentRect.width}px`,
        height: `${contentRect.height}px`,
      }}
    />
  ) : (
    <ZoomableImage
      src={file.absolutePath}
      contentRect={contentRect}
      prevImage={uiStore.firstItem - 1 >= 0 ? decrImgIndex : undefined}
      nextImage={uiStore.firstItem + 1 < fileList.length ? incrImgIndex : undefined}
    />
  );
});

const handleFlyoutBlur = (e: React.FocusEvent) => {
  if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) {
    const dialog = e.currentTarget.lastElementChild as HTMLDialogElement;
    if (dialog.open) {
      dialog.close();
    }
  }
};

interface ILayoutProps {
  contentRect: Rectangle;
  select: (file: ClientFile, selectAdditive: boolean, selectRange: boolean) => void;
  lastSelectionIndex: React.MutableRefObject<number | undefined>;
  /** menu: [fileMenu, externalMenu] */
  showContextMenu: (x: number, y: number, menu: [JSX.Element, JSX.Element]) => void;
}

const Layout = observer(
  ({ contentRect, showContextMenu }: Omit<ILayoutProps, 'select' | 'lastSelectionIndex'>) => {
    const { uiStore, fileStore } = useContext(StoreContext);
    const fileList = fileStore.fileList;
    // Todo: Select by dragging a rectangle shape
    // Could maybe be accomplished with https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
    // Also take into account scrolling when dragging while selecting
    const { makeSelection, lastSelectionIndex } = useSelectionCursor();

    // useComputed to listen to fileSelection changes
    const handleFileSelect = useCallback(
      (selectedFile: ClientFile, selectAdditive: boolean, selectRange: boolean) => {
        const i = fileStore.getIndex(selectedFile.id);
        if (i === undefined) {
          return;
        }

        const isSelected = uiStore.fileSelection.has(selectedFile);

        const newSelection = makeSelection(i, selectRange);
        if (!selectAdditive) {
          uiStore.clearFileSelection();
        }
        if (selectRange) {
          uiStore.selectFiles(newSelection.map((i) => fileList[i]));
        } else if (selectAdditive) {
          // Add or subtract to the selection
          isSelected ? uiStore.deselectFile(selectedFile) : uiStore.selectFile(selectedFile);
        } else {
          // Only select this file.
          uiStore.selectFile(selectedFile);
        }
      },
      [fileStore, uiStore, makeSelection, fileList],
    );

    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        let index = lastSelectionIndex.current;
        if (index === undefined) {
          return;
        }
        if (e.key === 'ArrowLeft' && index > 0) {
          index -= 1;
        } else if (e.key === 'ArrowRight' && index < fileList.length - 1) {
          index += 1;
        } else {
          return;
        }
        handleFileSelect(fileList[index], e.ctrlKey || e.metaKey, e.shiftKey);
      };

      const throttledKeyDown = throttle(onKeyDown, 50);

      window.addEventListener('keydown', throttledKeyDown);
      return () => window.removeEventListener('keydown', throttledKeyDown);
    }, [fileList, uiStore, handleFileSelect, lastSelectionIndex]);

    if (uiStore.isSlideMode) {
      return <SlideGallery contentRect={contentRect} />;
    }
    switch (uiStore.method) {
      case 'grid':
        return (
          <GridGallery
            contentRect={contentRect}
            select={handleFileSelect}
            lastSelectionIndex={lastSelectionIndex}
            showContextMenu={showContextMenu}
          />
        );
      // case 'masonry':
      //   return <MasonryGallery {...props} />;
      case 'list':
        return (
          <ListGallery
            contentRect={contentRect}
            select={handleFileSelect}
            lastSelectionIndex={lastSelectionIndex}
            showContextMenu={showContextMenu}
          />
        );
      default:
        return null;
    }
  },
);

const Gallery = () => {
  const { fileStore, uiStore } = useContext(StoreContext);
  const [contextState, { show, hide }] = useContextMenu({ initialMenu: [<></>, <></>] });
  const { open, x, y, menu } = contextState;
  const [fileMenu, externalMenu] = menu as [React.ReactNode, React.ReactNode];
  const { fileList } = fileStore;
  const [contentRect, setContentRect] = useState<Rectangle>({ width: 1, height: 1, x: 0, y: 0 });
  const container = useRef<HTMLDivElement>(null);

  const resizeObserver = useRef(
    new ResizeObserver((entries) => {
      const { contentRect: rect, target } = entries[0];
      setContentRect({
        width: rect.width,
        height: rect.height,
        x: (target as HTMLDivElement).offsetLeft,
        y: (target as HTMLDivElement).offsetTop,
      });
    }),
  );

  useEffect(() => {
    const observer = resizeObserver.current;
    if (container.current) {
      resizeObserver.current.observe(container.current);
    }
    return () => observer.disconnect();
  }, [fileList.length]);

  if (fileList.length === 0) {
    return <Placeholder />;
  }

  return (
    <div
      ref={container}
      id="gallery-content"
      className={`thumbnail-${uiStore.thumbnailSize} thumbnail-${uiStore.thumbnailShape}`}
      onClick={uiStore.clearFileSelection}
      onBlur={handleFlyoutBlur}
    >
      <Layout contentRect={contentRect} showContextMenu={show} />
      <ContextMenu open={open} x={x} y={y} onClose={hide}>
        <Menu>
          {fileMenu}
          <MenuDivider />
          <SubMenu icon={IconSet.VIEW_GRID} text="View method...">
            <LayoutMenuItems />
          </SubMenu>
          <SubMenu icon={IconSet.FILTER_NAME_DOWN} text="Sort by...">
            <SortMenuItems />
          </SubMenu>
          <MenuDivider />
          {externalMenu}
        </Menu>
      </ContextMenu>
    </div>
  );
};

export default observer(Gallery);

function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
  if (e.dataTransfer.types.includes(DnDType) && (e.target as HTMLElement).matches('.thumbnail')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    (e.target as HTMLElement).dataset[DnDAttribute.Target] = 'true';
  }
}

function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
  if (e.dataTransfer.types.includes(DnDType) && (e.target as HTMLElement).matches('.thumbnail')) {
    e.preventDefault();
  }
}

function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
  if (e.dataTransfer.types.includes(DnDType) && (e.target as HTMLElement).matches('.thumbnail')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
    (e.target as HTMLElement).dataset[DnDAttribute.Target] = 'false';
  }
}

// If the file is selected, add all selected items to the drag event, for
// exporting to your file explorer or programs like PureRef.
// Creating an event in the main process turned out to be the most robust,
// did many experiments with drag event content types. Creating a drag
// event with multiple images did not work correctly from the browser side
// (e.g. only limited to thumbnails, not full images).
const onDragStart = action(
  (e: React.DragEvent, index: number | undefined, uiStore: UiStore, fileList: ClientFile[]) => {
    if (index === undefined) {
      return;
    }
    const file = fileList[index];
    if (!uiStore.fileSelection.has(file)) {
      return;
    }
    e.preventDefault();
    if (uiStore.fileSelection.size > 1) {
      RendererMessenger.startDragExport(Array.from(uiStore.fileSelection, (f) => f.absolutePath));
    } else {
      RendererMessenger.startDragExport([file.absolutePath]);
    }

    // However, from the main process, there is no way to attach some information to indicate it's an "internal event" that shouldn't trigger the drop overlay
    // So we can store the date when the event starts... Hacky but it works :)
    (window as any).internalDragStart = new Date();
  },
);

const onDrop = action(
  (
    e: React.DragEvent<HTMLElement>,
    index: number | undefined,
    uiStore: UiStore,
    files: ClientFile[],
  ) => {
    if (index === undefined) {
      return;
    }
    const file = files[index];
    const ctx = uiStore.getTagContextItems(e.dataTransfer.getData(DnDType));
    ctx.tags.forEach((tag) => {
      file.addTag(tag);
      tag.subTags.forEach(file.addTag);
    });
    e.dataTransfer.dropEffect = 'none';
    (e.target as HTMLElement).dataset[DnDAttribute.Target] = 'false';
  },
);

// WIP > better general thumbsize. See if we kind find better size ratio for different screensize.
// We'll have less loss of space perhaps
// https://stackoverflow.com/questions/57327107/typeerror-cannot-read-property-getprimarydisplay-of-undefined-screen-getprim
// const { screen } = remote;
// const { width } = screen.getPrimaryDisplay().workAreaSize;
// const CELL_SMALL = (width / 10) - 16;
// const CELL_MEDIUM = (width / 6) - 8;
// const CELL_LARGE = (width / 4) - 8;
// // Should be same as CSS variable --thumbnail-size + padding (adding padding, though in px)
// const CELL_SIZE_SMALL = CELL_SMALL - 2;
// const CELL_SIZE_MEDIUM = CELL_MEDIUM - 2;
// const CELL_SIZE_LARGE = CELL_LARGE - 2;
// Should be same as CSS variable --thumbnail-size + padding (adding padding, though in px)
// TODO: Use computed styles to access the CSS variables
const PADDING = 8;
const CELL_SIZE_SMALL = 160 + PADDING;
const CELL_SIZE_MEDIUM = 240 + PADDING;
const CELL_SIZE_LARGE = 320 + PADDING;
// Similar to the flex-shrink CSS property, the thumbnail will shrink, so more
// can fit into one row.
const SHRINK_FACTOR = 0.9;

function getThumbnailSize(sizeType: 'small' | 'medium' | 'large') {
  if (sizeType === 'small') {
    return [CELL_SIZE_SMALL * SHRINK_FACTOR, CELL_SIZE_SMALL];
  } else if (sizeType === 'medium') {
    return [CELL_SIZE_MEDIUM * SHRINK_FACTOR, CELL_SIZE_MEDIUM];
  }
  return [CELL_SIZE_LARGE * SHRINK_FACTOR, CELL_SIZE_LARGE];
}

function get_column_layout(width: number, minSize: number, maxSize: number): [number, number] {
  const numColumns = Math.trunc(width / minSize);
  let cellSize = Math.trunc(width / numColumns);
  if (isNaN(cellSize) || !isFinite(cellSize)) {
    cellSize = minSize;
  }
  cellSize = Math.min(cellSize, maxSize);
  return [numColumns, cellSize];
}

/** Generates a unique key for an element in the fileList */
const getItemKey = action((index: number, data: ClientFile[]): string => {
  return data[index].id;
});

function getListItemIndex(
  e: React.MouseEvent,
  matches: (target: HTMLElement) => boolean,
): number | undefined {
  const target = e.target as HTMLElement;
  if (matches(target)) {
    e.stopPropagation();
    // Each thumbnail is in a gridcell which is owned by a row.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rowIndex = target.closest('[role="row"]')!.getAttribute('aria-rowindex')!;
    return parseInt(rowIndex) - 1;
  }
  return undefined;
}

function getGridItemIndex(
  e: React.MouseEvent,
  numColumns: number,
  matches: (target: HTMLElement) => boolean,
): number | undefined {
  const target = e.target as HTMLElement;
  if (matches(target)) {
    e.stopPropagation();
    // Each thumbnail is in a gridcell which is owned by a row.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rowIndex = target.closest('[role="row"]')!.getAttribute('aria-rowindex')!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const colIndex = target.closest('[role="gridcell"')!.getAttribute('aria-colindex')!;
    const offset = (parseInt(rowIndex) - 1) * numColumns;
    return offset + parseInt(colIndex) - 1;
  }
  return undefined;
}
