import {
  ADULT_CHALLENGE_SUBSTRINGS as CHALLENGE_SUBSTRINGS,
  ADULT_DOMAINS,
  DEFAULT_ADULT_ACCEPT_LANGUAGE as DEFAULT_ACCEPT_LANGUAGE,
  DEFAULT_ADULT_UNAVAILABLE_MESSAGE as DEFAULT_UNAVAILABLE_MESSAGE,
  DEFAULT_ADULT_USER_AGENT as DEFAULT_USER_AGENT,
  isAdultMediaChallenge as isAuthenticationChallenge,
  matchesHost,
} from '../http-utils.js';

export const name = 'adult-media';
export const publiclyReadable = true;

export {
  DEFAULT_USER_AGENT,
  DEFAULT_ACCEPT_LANGUAGE,
  ADULT_DOMAINS,
  DEFAULT_UNAVAILABLE_MESSAGE,
  CHALLENGE_SUBSTRINGS,
  isAuthenticationChallenge,
};

export function matches(hostname) {
  return matchesHost(hostname, ADULT_DOMAINS);
}

export function headers() {
  return {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
  };
}

export function readerTarget(url) {
  return String(url);
}

export function unavailableMessage() {
  return DEFAULT_UNAVAILABLE_MESSAGE;
}
