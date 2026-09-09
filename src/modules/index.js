import articlesRoutes from './articles/articles.routes.js';
import analyticsRoutes from './analytics/analytics.routes.js';
import dashboardRoutes from './dashboard/dashboard.routes.js';
import searchRoutes from './search/search.routes.js';
import chatRoutes from './chat/chat.routes.js';

export default async function (fastify) {
  fastify.register(articlesRoutes, { prefix: '/articles' });
  fastify.register(analyticsRoutes, { prefix: '/analytics' });
  fastify.register(dashboardRoutes, { prefix: '/dashboard' });
  fastify.register(searchRoutes, { prefix: '/search' });
  fastify.register(chatRoutes, { prefix: '/api/v1' });
}
