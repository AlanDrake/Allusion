import React from 'react';
import SVG from 'react-inlinesvg';

import PreloadIcon from '../../resources/icons/preload.svg';

const SplashScreen = () => (
  // Using inline style since css file might not have been loaded
  <div
    style={{ position: 'fixed', top: '25%', width: '100%', textAlign: 'center', color: '#f5f8fa' }}
  >
    <svg style={{ width: 0 }}>
      <defs>
        <linearGradient id="yellow-blue" x2="1" y2="1">
          <stop offset="0%" stopColor="#eef112" stopOpacity="1">
            <animate attributeName="stop-color" values="#eef112;#3bb6fc;#eef112;#3bb6fc;#eef112;#3bb6fc" dur="3s"
              repeatCount="indefinite" />
          </stop>
          <stop offset="100%" stopColor="#3bb6fc" stopOpacity="1">
            <animate attributeName="stop-color" values="#eef112;#3bb6fc;#eef112;#3bb6fc;#eef112;#3bb6fc" dur="2s"
              repeatCount="indefinite" />
            <animate attributeName="offset" values=".95;.80;.60;.40;.20;0;.20;.40;.60;.80;.95" dur="2s" />
          </stop>
        </linearGradient>
      </defs>
    </svg>

    <SVG src={PreloadIcon} style={{ fill: 'url(#yellow-blue)', width: '48px', height: '48px' }}/>

    <h2 style={{ margin: 0 }}>Allusion</h2>
  </div>
);

export default SplashScreen;