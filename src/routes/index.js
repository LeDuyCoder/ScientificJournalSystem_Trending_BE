import { Router } from 'express';
import articlesRoutes from './articles.routes.js';
import analyticsRoutes from './analytics.routes.js';

import dashboardRoutes from './dashboard.routes.js';
import chatRoutes from './chat.routes.js';

const router = Router();

/**
 * Mount all feature routes.
 */
router.use('/articles', articlesRoutes);
router.use('/analytics', analyticsRoutes);

router.use('/dashboard', dashboardRoutes);

router.use('/api/v1', chatRoutes);
export default router;

