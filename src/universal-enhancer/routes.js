import { registerAllRoutes, allModularRoutes } from './routes/index.js';

export function registerBuiltinRoutes(enhancer) {
  return registerAllRoutes(enhancer);
}

export { allModularRoutes, registerAllRoutes };
export default registerBuiltinRoutes;
