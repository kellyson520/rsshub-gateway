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
  resolveSourceMode as resolveMode,
  safeHost,
} from '../http-utils.js';

export const adapters = [iwara, x, instagram, telegram, ehviewer, pixiv, linuxdo, adultMedia];

export {
  DEFAULT_UNAVAILABLE_MESSAGE,
  defaultAdapter,
  resolveMode,
};

export function adapterForUrl(url) {
  const hostname = safeHost(url, '');
  if (!hostname) {
    return { ...defaultAdapter };
  }
  return { ...defaultAdapter, ...adapters.find((adapter) => adapter.matches(hostname)) };
}

export function getSupportedSourceNames() {
  return adapters.map((adapter) => adapter.name).filter(Boolean);
}

export function isKnownSourceUrl(url) {
  const adapter = adapterForUrl(url);
  return adapter && adapter.name !== 'unknown';
}
