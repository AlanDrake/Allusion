import { action, observable, computed, observe, runInAction } from 'mobx';
import fse from 'fs-extra';

import Backend from '../../backend/Backend';
import { ClientFile, IFile, getMetaData } from '../../entities/File';
import RootStore from './RootStore';
import { ID, generateId } from '../../entities/ID';
import { SearchCriteria, ClientArraySearchCriteria } from '../../entities/SearchCriteria';
import { getThumbnailPath, debounce, needsThumbnail, promiseAllLimit } from '../utils';
import { ClientTag } from '../../entities/Tag';
import { FileOrder } from '../../backend/DBRepository';
import { ClientLocation } from '../../entities/Location';

const FILE_STORAGE_KEY = 'Allusion_File';

/** These fields are stored and recovered when the application opens up */
const PersistentPreferenceFields: Array<keyof FileStore> = ['fileOrder', 'orderBy'];

const enum Content {
  All,
  Missing,
  Untagged,
  Query,
}

class FileStore {
  readonly fileList = observable<ClientFile>([]);
  /** A map of file ID to its index in the file list, for quick lookups by ID */
  private readonly index = new Map<ID, number>();

  /** The origin of the current files that are shown */
  @observable private content: Content = Content.All;
  @observable fileOrder: FileOrder = FileOrder.DESC;
  @observable orderBy: keyof IFile = 'dateAdded';
  @observable numUntaggedFiles = 0;
  @observable numMissingFiles = 0;

  private backend: Backend;
  private rootStore: RootStore;

  constructor(backend: Backend, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;

    // Store preferences immediately when anything is changed
    const debouncedPersist = debounce(this.storePersistentPreferences, 200).bind(this);
    PersistentPreferenceFields.forEach((f) => observe(this, f, debouncedPersist));
  }

  @computed get showsAllContent() {
    return this.content === Content.All;
  }

  @computed get showsUntaggedContent() {
    return this.content === Content.Untagged;
  }

  @computed get showsMissingContent() {
    return this.content === Content.Missing;
  }

  @computed get showsQueryContent() {
    return this.content === Content.Query;
  }

  @action.bound switchFileOrder() {
    this.setFileOrder(this.fileOrder === FileOrder.DESC ? FileOrder.ASC : FileOrder.DESC);
    this.refetch();
  }

  @action.bound orderFilesBy(prop: keyof IFile = 'dateAdded') {
    this.setOrderBy(prop);
    this.refetch();
  }

  @action.bound setContentQuery() {
    this.content = Content.Query;
  }

  @action.bound setContentAll() {
    this.content = Content.All;
  }

  @action.bound setContentUntagged() {
    this.content = Content.Untagged;
  }

  @action.bound async init(autoLoadFiles: boolean) {
    if (autoLoadFiles) {
      const fetchedFiles = await this.backend.fetchFiles(this.orderBy, this.fileOrder);
      this.updateFromBackend(fetchedFiles);
    }
  }

  @action.bound async addFile(path: string, locationId: ID, dateAdded: Date = new Date()) {
    const loc = this.getLocation(locationId)!;
    const file = new ClientFile(this, {
      id: generateId(),
      locationId,
      absolutePath: path,
      relativePath: path.replace(loc.path, ''),
      dateAdded: dateAdded,
      dateModified: new Date(),
      tags: [],
      ...(await getMetaData(path)),
    });
    // The function caller is responsible for handling errors.
    await this.backend.createFile(file.serialize());
    runInAction(() => {
      this.index.set(file.id, this.fileList.length);
      this.fileList.push(file);
    });
    this.incrementNumUntaggedFiles();
    return file;
  }

  /**
   * Marks file as missing
   *
   * Marking a file as missing will remove the file from the FileStore stats and
   * automatically 'freezes' the object. Freezing means that changes made to a
   * file will not be saved in the database.
   * @param file
   */
  @action.bound hideFile(file: ClientFile) {
    file.setBroken(true);
    this.rootStore.uiStore.deselectFile(file);
    this.incrementNumMissingFiles();
    if (file.tags.size === 0) {
      this.decrementNumUntaggedFiles();
    }
  }

  @action.bound async deleteFiles(ids: ID[]) {
    if (ids.length === 0) {
      return;
    }

    try {
      // Remove from backend
      // Deleting non-exiting keys should not throw an error!
      await this.backend.removeFiles(ids);

      // Remove files from stores
      const removedFilePaths: string[] = this.removeFiles(ids);

      // Remove thumbnails
      return Promise.all(
        removedFilePaths.map(async (path) => {
          const thumbnailPath = getThumbnailPath(path, this.rootStore.uiStore.thumbnailDirectory);
          if (await fse.pathExists(thumbnailPath)) {
            return fse.remove(thumbnailPath);
          }
        }),
      );
    } catch (err) {
      console.error('Could not remove files', err);
    }
  }

  @action.bound refetch() {
    if (this.showsAllContent) {
      this.fetchAllFiles();
    } else if (this.showsUntaggedContent) {
      this.fetchUntaggedFiles();
    } else if (this.showsQueryContent) {
      this.fetchFilesByQuery();
    } else if (this.showsMissingContent) {
      this.fetchMissingFiles();
    }
  }

  @action.bound async fetchAllFiles() {
    try {
      this.rootStore.uiStore.closeQuickSearch();
      const fetchedFiles = await this.backend.fetchFiles(this.orderBy, this.fileOrder);
      this.setContentAll();
      this.updateFromBackend(fetchedFiles);
    } catch (err) {
      console.error('Could not load all files', err);
    }
  }

  @action.bound async fetchUntaggedFiles() {
    try {
      const { uiStore } = this.rootStore;
      uiStore.closeQuickSearch();
      const criteria = new ClientArraySearchCriteria('tags', []).serialize();
      const fetchedFiles = await this.backend.searchFiles(
        criteria,
        this.orderBy,
        this.fileOrder,
        uiStore.searchMatchAny,
      );
      this.setContentUntagged();
      this.updateFromBackend(fetchedFiles);
    } catch (err) {
      console.error('Could not load all files', err);
    }
  }

  @action.bound async fetchMissingFiles() {
    try {
      const {
        orderBy,
        fileOrder,
        rootStore: { uiStore },
      } = this;

      uiStore.closeQuickSearch();
      this.setContentMissing();

      // Fetch all files, then check their existence and only show the missing ones
      // Similar to {@link updateFromBackend}, but the existence check needs to be awaited before we can show the images
      const backendFiles = await this.backend.fetchFiles(orderBy, fileOrder);

      // For every new file coming in, either re-use the existing client file if it exists,
      // or construct a new client file
      const [newClientFiles, reusedStatus] = this.filesFromBackend(backendFiles);

      // Dispose of unused files
      for (const oldFile of this.fileList) {
        if (!reusedStatus.has(oldFile.id)) {
          oldFile.dispose();
        }
      }

      // We don't store whether files are missing (since they might change at any time)
      // So we have to check all files and check their existence them here
      const existenceCheckPromises = newClientFiles.map((clientFile) => async () => {
        clientFile.setBroken(!(await fse.pathExists(clientFile.absolutePath)));
      });

      const N = 50; // TODO: same here as in fetchFromBackend: number of concurrent checks should be system dependent
      await promiseAllLimit(existenceCheckPromises, N);
      const missingClientFiles = newClientFiles.filter((file) => file.isBroken);

      runInAction(() => this.fileList.replace(missingClientFiles));
      this.updateFileListState();
      this.cleanFileSelection();
    } catch (err) {
      console.error('Could not load broken files', err);
    }
  }

  @action.bound async fetchFilesByQuery() {
    const { uiStore } = this.rootStore;
    const criteria = this.rootStore.uiStore.searchCriteriaList.map((c) => c.serialize());
    if (criteria.length === 0) {
      return this.fetchAllFiles();
    }
    try {
      const fetchedFiles = await this.backend.searchFiles(
        criteria as [SearchCriteria<IFile>],
        this.orderBy,
        this.fileOrder,
        uiStore.searchMatchAny,
      );
      this.setContentQuery();
      this.updateFromBackend(fetchedFiles);
    } catch (e) {
      console.log('Could not find files based on criteria', e);
    }
  }

  @action.bound async fetchFilesByIDs(files: ID[]) {
    try {
      const fetchedFiles = await this.backend.fetchFilesByID(files);
      this.updateFromBackend(fetchedFiles);
    } catch (e) {
      console.log('Could not find files based on IDs', e);
    }
  }

  @action.bound incrementNumUntaggedFiles() {
    this.numUntaggedFiles++;
  }

  @action.bound decrementNumUntaggedFiles() {
    if (this.numUntaggedFiles === 0) {
      throw new Error('Invalid Database State: Cannot have less than 0 untagged files.');
    }
    this.numUntaggedFiles--;
  }

  // Removes all items from fileList
  @action.bound clearFileList() {
    this.fileList.clear();
    this.index.clear();
  }

  get(id: ID): ClientFile | undefined {
    const fileIndex = this.index.get(id);
    return fileIndex !== undefined ? this.fileList[fileIndex] : undefined;
  }

  getIndex(id: ID): number | undefined {
    return this.index.get(id);
  }

  getTags(tags: Set<ID>): ClientTag[] {
    return Array.from(this.rootStore.tagStore.getIterFrom(tags));
  }

  getLocation(location: ID): ClientLocation {
    const loc = this.rootStore.locationStore.get(location);
    if (!loc) {
      console.warn('Location of file was not found! This should never happen!', location);
      return this.rootStore.locationStore.defaultLocation;
    }
    return loc;
  }

  save(file: IFile) {
    file.dateModified = new Date();
    this.backend.saveFile(file);
  }

  recoverPersistentPreferences() {
    const prefsString = localStorage.getItem(FILE_STORAGE_KEY);
    if (prefsString) {
      try {
        const prefs = JSON.parse(prefsString);
        this.setFileOrder(prefs.fileOrder);
        this.setOrderBy(prefs.orderBy);
      } catch (e) {
        console.log('Cannot parse persistent preferences:', FILE_STORAGE_KEY, e);
      }
    }
  }

  storePersistentPreferences() {
    const prefs: any = {};
    for (const field of PersistentPreferenceFields) {
      prefs[field] = this[field];
    }
    localStorage.setItem(FILE_STORAGE_KEY, JSON.stringify(prefs));
  }

  @action private removeFiles(ids: ID[]): string[] {
    const removedFilePaths: string[] = [];
    for (const id of ids) {
      const file = this.get(id);
      if (file !== undefined) {
        removedFilePaths.push(file.absolutePath);
        this.rootStore.uiStore.deselectFile(file);
        this.fileList.remove(file);
      }
    }
    this.updateFileListState();
    return removedFilePaths;
  }

  @action private updateFromBackend(backendFiles: IFile[]) {
    if (backendFiles.length === 0) {
      this.rootStore.uiStore.clearFileSelection();
      return this.clearFileList();
    }

    const locationIds = this.rootStore.locationStore.locationList.map((l) => l.id);

    // For every new file coming in, either re-use the existing client file if it exists,
    // or construct a new client file
    const [newClientFiles, reusedStatus] = this.filesFromBackend(backendFiles);

    // Dispose of Client files that are not re-used
    for (const file of this.fileList) {
      if (!reusedStatus.has(file.id)) {
        file.dispose();
      }
    }

    // Check existence of new files asynchronously, no need to wait until they can be showed
    // we can simply check whether they exist after they start rendering
    const existenceCheckPromises = newClientFiles.map((clientFile) => async () => {
      clientFile.setBroken(!(await fse.pathExists(clientFile.absolutePath)));

      // TODO: DEBUG CHECK. Remove this when going out for release version
      // Check if file belongs to a location; shouldn't be needed, but useful for during development
      if (!locationIds.includes(clientFile.locationId)) {
        console.warn(
          'DEBUG: Found a file that does not belong to any location! Will still show up. SHOULD NEVER HAPPEN',
          clientFile,
        );
      }
    });

    // Run the existence check with at most N checks in parallel
    // TODO: Should make N configurable, or determine based on the system/disk performance
    // NOTE: This is _not_ await intentionally, since we want to show the files to the user as soon as possible
    const N = 50;
    promiseAllLimit(existenceCheckPromises, N).catch((e) =>
      console.error('An error occured during existence checking!', e),
    );

    runInAction(() => this.fileList.replace(newClientFiles));
    this.updateFileListState();
    this.cleanFileSelection();
  }

  /** Remove files from selection that are not in the file list anymore */
  @action private cleanFileSelection() {
    const { fileSelection } = this.rootStore.uiStore;
    for (const id of fileSelection) {
      if (!this.index.has(id)) {
        fileSelection.delete(id);
      }
    }
  }

  /**
   *
   * @param backendFiles
   * @returns A list of Client files, and a set of keys that was reused from the existing fileList
   */
  @action private filesFromBackend(backendFiles: IFile[]): [ClientFile[], Set<ID>] {
    const reusedStatus = new Set<ID>();

    const clientFiles = backendFiles.map((f) => {
      // Might already exist!
      const existingFile = this.get(f.id);
      if (existingFile) {
        reusedStatus.add(existingFile.id);
        return existingFile;
      }

      // Otherwise, create new one.
      // TODO: Maybe better performance by always keeping the same pool of client files,
      // and just replacing their properties instead of creating new objects
      // But that's micro optimization...

      const file = new ClientFile(this, f);
      // Initialize the thumbnail path so the image can be loaded immediately when it mounts.
      // To ensure the thumbnail actually exists, the `ensureThumbnail` function should be called
      file.thumbnailPath = needsThumbnail(f.width, f.height)
        ? getThumbnailPath(f.absolutePath, this.rootStore.uiStore.thumbnailDirectory)
        : f.absolutePath;
      return file;
    });

    return [clientFiles, reusedStatus];
  }

  /** Derive fields from `fileList`
   * - `index`
   * - `numUntaggedFiles`
   * - `numMissingFiles`
   */
  @action private updateFileListState() {
    let missingFiles = 0;
    let untaggedFiles = 0;
    this.index.clear();
    for (let index = 0; index < this.fileList.length; index++) {
      const file = this.fileList[index];
      if (file.isBroken) {
        missingFiles += 1;
      } else if (file.tags.size === 0) {
        untaggedFiles += 1;
      }
      this.index.set(file.id, index);
    }
    this.numMissingFiles = missingFiles;
    this.numUntaggedFiles = untaggedFiles;
  }

  @action private setFileOrder(order: FileOrder = FileOrder.DESC) {
    this.fileOrder = order;
  }

  @action private setOrderBy(prop: keyof IFile = 'dateAdded') {
    this.orderBy = prop;
  }

  @action private setContentMissing() {
    this.content = Content.Missing;
  }

  @action private incrementNumMissingFiles() {
    this.numMissingFiles++;
  }
}

export default FileStore;
