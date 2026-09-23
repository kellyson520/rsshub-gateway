// 现有首批 9 站点
import epicRoutes from './epic.js';
import bilibiliRoutes from './bilibili.js';
import weiboRoutes from './weibo.js';
import zhihuRoutes from './zhihu.js';
import githubRoutes from './github.js';
import dmhyRoutes from './dmhy.js';
import bangumiRoutes from './bangumi.js';
import steamRoutes from './steam.js';
import mangadexRoutes from './mangadex.js';

// 第一批次迁移：社区与 BT 种子
import v2exRoutes from './v2ex.js';
import nodeseekRoutes from './nodeseek.js';
import linuxdoRoutes from './linuxdo.js';
import acgripRoutes from './acgrip.js';
import nyaaRoutes from './nyaa.js';

// 第二批次迁移：创作者赞助与同人漫画
import kemonoRoutes from './kemono.js';
import coomerRoutes from './coomer.js';
import skebRoutes from './skeb.js';
import fanboxRoutes from './fanbox.js';
import wnacgRoutes from './wnacg.js';
import dlsiteRoutes from './dlsite.js';
import uraakaRoutes from './uraaka.js';

// 第三批次迁移：影视与流媒体
import sehuatangRoutes from './sehuatang.js';
import chikubiRoutes from './chikubi.js';
import hanime1Routes from './hanime1.js';
import missavRoutes from './missav.js';
import jableRoutes from './jable.js';
import javbusRoutes from './javbus.js';
import javdbRoutes from './javdb.js';
import ggjavRoutes from './ggjav.js';
import airavRoutes from './airav.js';
import iwaraRoutes from './iwara.js';
import ehRoutes from './eh.js';

export const routeModules = [
  // 基础娱乐与社交
  { name: 'epic', routes: epicRoutes },
  { name: 'bilibili', routes: bilibiliRoutes },
  { name: 'weibo', routes: weiboRoutes },
  { name: 'zhihu', routes: zhihuRoutes },
  { name: 'github', routes: githubRoutes },
  { name: 'dmhy', routes: dmhyRoutes },
  { name: 'bangumi', routes: bangumiRoutes },
  { name: 'steam', routes: steamRoutes },
  { name: 'mangadex', routes: mangadexRoutes },

  // 第一批次
  { name: 'v2ex', routes: v2exRoutes },
  { name: 'nodeseek', routes: nodeseekRoutes },
  { name: 'linuxdo', routes: linuxdoRoutes },
  { name: 'acgrip', routes: acgripRoutes },
  { name: 'nyaa', routes: nyaaRoutes },

  // 第二批次
  { name: 'kemono', routes: kemonoRoutes },
  { name: 'coomer', routes: coomerRoutes },
  { name: 'skeb', routes: skebRoutes },
  { name: 'fanbox', routes: fanboxRoutes },
  { name: 'wnacg', routes: wnacgRoutes },
  { name: 'dlsite', routes: dlsiteRoutes },
  { name: 'uraaka', routes: uraakaRoutes },

  // 第三批次
  { name: 'sehuatang', routes: sehuatangRoutes },
  { name: 'chikubi', routes: chikubiRoutes },
  { name: 'hanime1', routes: hanime1Routes },
  { name: 'missav', routes: missavRoutes },
  { name: 'jable', routes: jableRoutes },
  { name: 'javbus', routes: javbusRoutes },
  { name: 'javdb', routes: javdbRoutes },
  { name: 'ggjav', routes: ggjavRoutes },
  { name: 'airav', routes: airavRoutes },
  { name: 'iwara', routes: iwaraRoutes },
  { name: 'eh', routes: ehRoutes },
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
