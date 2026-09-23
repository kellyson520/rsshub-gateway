import epicRoutes from './epic.js';
import bilibiliRoutes from './bilibili.js';
import weiboRoutes from './weibo.js';
import zhihuRoutes from './zhihu.js';
import githubRoutes from './github.js';
import dmhyRoutes from './dmhy.js';
import bangumiRoutes from './bangumi.js';
import steamRoutes from './steam.js';
import mangadexRoutes from './mangadex.js';

export const routeModules = [
  { name: 'epic', routes: epicRoutes },
  { name: 'bilibili', routes: bilibiliRoutes },
  { name: 'weibo', routes: weiboRoutes },
  { name: 'zhihu', routes: zhihuRoutes },
  { name: 'github', routes: githubRoutes },
  { name: 'dmhy', routes: dmhyRoutes },
  { name: 'bangumi', routes: bangumiRoutes },
  { name: 'steam', routes: steamRoutes },
  { name: 'mangadex', routes: mangadexRoutes },
];

export const allModularRoutes = routeModules.flatMap((m) => m.routes);

export function registerAllRoutes(registry) {
  if (!registry || typeof registry.register !== 'function') {
    throw new TypeError('registry with register() method is required');
  }

  let count = 0;
  for (const module of routeModules) {
    for (const r of module.routes) {
      if (registry.register(r)) {
        count++;
      }
    }
  }
  return count;
}

export default registerAllRoutes;
