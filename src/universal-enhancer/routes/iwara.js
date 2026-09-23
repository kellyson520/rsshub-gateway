import {
  fetchIwaraUser,
  fetchIwaraVideos,
  iwaraThumbnailUrl,
  renderIwaraFeed,
} from '../../../src/adapters/iwara.js';

export const routes = [
  {
    path: '/iwara/users/:username/:kind?',
    name: 'Iwara 创作者视频与插画',
    example: '/iwara/users/zzzwen/video',
    parameters: {
      username: '用户名',
      kind: '类型 (video, image，缺省 video)',
    },
    cacheTtl: 900,
    handler: async (ctx) => {
      const username = ctx.params.username;
      const kind = ctx.params.kind || 'video';
      const user = await fetchIwaraUser(ctx.fetchJson, username);
      if (!user?.id) throw new Error('user not found');
      const videos = await fetchIwaraVideos(ctx.fetchJson, user.id, { kind });
      const rssXml = renderIwaraFeed({
        username,
        kind,
        videos,
        selfUrl: `/iwara/users/${username}/${kind}`,
      });
      const mediaUrls = videos
        .map((video) => {
          const isImage = kind === 'image';
          const file = isImage ? (video.files?.[0] || video.thumbnail || {}) : (video.file || {});
          const id = isImage ? video.thumbnail?.id : file.id;
          return id ? iwaraThumbnailUrl(id, 0) : '';
        })
        .filter(Boolean);
      return { rssXml, mediaUrls, cacheHint: { ttl: 900 } };
    },
  },
];

export default routes;
