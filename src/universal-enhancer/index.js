import { createRouteRegistry } from './registry.js';
import { createEnhancerContext } from './context.js';
import { renderStandardFeed, escapeXml, formatRfc822Date } from './feed-builder.js';
import { registerBuiltinRoutes } from './routes.js';

export function createUniversalEnhancer(options = {}) {
  const registry = createRouteRegistry(options);
  registerBuiltinRoutes(registry);

  return {
    ...registry,
    renderStandardFeed,
    createEnhancerContext,
  };
}

export {
  renderStandardFeed,
  createEnhancerContext,
  createRouteRegistry,
  registerBuiltinRoutes,
  escapeXml,
  formatRfc822Date,
};
