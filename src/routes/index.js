import { Router } from 'express';
import articlesRoutes from './articles.routes.js';
import analyticsRoutes from './analytics.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import searchRoutes from './search.routes.js';
import chatRoutes from './chat.routes.js';

import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireProjectAccess } from '../middlewares/projectAccess.middleware.js';

const router = Router();

/**
 * Mount all feature routes.
 */
router.use('/articles', requireAuth, requireProjectAccess, articlesRoutes);
router.use('/analytics', requireAuth, requireProjectAccess, analyticsRoutes);
router.use('/dashboard', requireAuth, requireProjectAccess, dashboardRoutes);
router.use('/search', requireAuth, searchRoutes);

router.use('/api/v1', requireAuth, chatRoutes);

export default router;
