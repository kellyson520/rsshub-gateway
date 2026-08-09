import * as iwara from './iwara.js';
import * as x from './x.js';
import * as instagram from './instagram.js';
import * as telegram from './telegram.js';
import * as ehviewer from './ehviewer.js';

const adapters = [iwara, x, instagram, telegram, ehviewer];

const defaultAdapter = {
  name: 'unknown',
  headers: () => ({}),
  readerTarget: (url) => String(url),
  isGalleryUrl: () => false,
  galleryPageUrls: () => [],
  imagePageUrls: () => [],
  firstImagePageUrl: () => '',
  unavailableMessage: () => '该来源暂时无法读取，请稍后重试或打开原始来源。',
};

export function adapterForUrl(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  return { ...defaultAdapter, ...adapters.find((adapter) => adapter.matches(hostname)) };
}

export function resolveMode(source, config = {}) {
  if (source === 'iwara') return config.cookie ? 'authenticated' : 'public';
  if (source === 'x') return config.authToken ? 'authenticated' : 'public';
  if (source === 'instagram') return config.cookie ? 'authenticated' : 'public';
  return 'public';
}
