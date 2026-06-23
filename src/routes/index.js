import { Router } from 'express';
import articlesRoutes from './articles.routes.js';
import analyticsRoutes from './analytics.routes.js';

import dashboardRoutes from './dashboard.routes.js';
const router = Router();

/**
 * Mount all feature routes.
 */
router.use('/articles', articlesRoutes);
router.use('/analytics', analyticsRoutes);

router.use('/dashboard', dashboardRoutes);
export default router;

