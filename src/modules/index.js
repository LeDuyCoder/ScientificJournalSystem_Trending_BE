import articlesRoutes from './articles/articles.routes.js';
import analyticsRoutes from './analytics/analytics.routes.js';
import dashboardRoutes from './dashboard/dashboard.routes.js';
import searchRoutes from './search/search.routes.js';
import chatRoutes from './chat/chat.routes.js';
import { requireAuth } from './auth/auth.middleware.js';
import { ensureProjectScope } from './analytics/services/scope.service.js';

export default async function (fastify) {
  // 1. Kiểm tra xác thực Account từ cookies cho toàn bộ các module API
  fastify.addHook('preHandler', requireAuth);

  // 2. Tự động kiểm tra và khởi tạo phạm vi bài báo cho project nếu có project_id
  fastify.addHook('preHandler', async (request, reply) => {
    const projectId = request.query?.project_id || request.params?.project_id || request.params?.id;
    if (projectId) {
      await ensureProjectScope(projectId);
    }
  });

  fastify.register(articlesRoutes, { prefix: '/articles' });
  fastify.register(analyticsRoutes, { prefix: '/analytics' });
  fastify.register(dashboardRoutes, { prefix: '/dashboard' });
  fastify.register(searchRoutes, { prefix: '/search' });
  fastify.register(chatRoutes, { prefix: '/api/v1' });
}

