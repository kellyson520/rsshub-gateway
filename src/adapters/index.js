import * as iwara from './iwara.js';
import * as x from './x.js';
import * as instagram from './instagram.js';
import * as telegram from './telegram.js';
import * as ehviewer from './ehviewer.js';
import * as pixiv from './pixiv.js';
import * as linuxdo from './linuxdo.js';
import * as adultMedia from './adult-media.js';

import {
  DEFAULT_ADAPTER_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  defaultAdapter,
  getAdapterSourceNames,
  isKnownAdapterTarget,
  matchAdapter,
  resolveSourceMode as resolveMode,
  safeHost,
} from '../http-utils.js';

export const adapters = [iwara, x, instagram, telegram, ehviewer, pixiv, linuxdo, adultMedia];

export {
  DEFAULT_UNAVAILABLE_MESSAGE,
  defaultAdapter,
  resolveMode,
  matchAdapter,
  getAdapterSourceNames,
  isKnownAdapterTarget,
};

export function adapterForUrl(url) {
  return matchAdapter(url, adapters, defaultAdapter);
}

export function getSupportedSourceNames() {
  return getAdapterSourceNames(adapters);
}

export function isKnownSourceUrl(url) {
  return isKnownAdapterTarget(url, adapters, defaultAdapter);
}
