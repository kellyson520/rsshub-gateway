import {
  createFetchdClient,
  DEFAULT_FETCHD_BASE_URL,
  DEFAULT_FETCHD_TIMEOUT_MS,
  FETCHD_TIMEOUT_SLACK_MS,
  fetchdJson,
  MAX_FETCHD_TIMEOUT_MS,
} from './http-utils.js';

export const DEFAULT_BASE_URL = process.env.IWARA_FETCHD_URL || DEFAULT_FETCHD_BASE_URL;

export {
  createFetchdClient,
  DEFAULT_FETCHD_TIMEOUT_MS,
  MAX_FETCHD_TIMEOUT_MS,
  FETCHD_TIMEOUT_SLACK_MS,
  fetchdJson,
};
