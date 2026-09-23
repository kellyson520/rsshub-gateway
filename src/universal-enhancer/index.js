import { createRouteRegistry } from './registry.js';
import { createEnhancerContext } from './context.js';
import { renderStandardFeed, escapeXml, formatRfc822Date } from './feed-builder.js';
import { registerBuiltinRoutes, allModularRoutes, registerAllRoutes } from './routes.js';

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
  registerAllRoutes,
  allModularRoutes,
  escapeXml,
  formatRfc822Date,
};
