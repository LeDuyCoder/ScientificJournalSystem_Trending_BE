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
router.use('/articles', articlesRoutes);
router.use('/analytics', requireProjectAccess, analyticsRoutes);
router.use('/dashboard', requireProjectAccess, dashboardRoutes);
router.use('/search', searchRoutes);

router.use('/api/v1', chatRoutes);

export default router;
