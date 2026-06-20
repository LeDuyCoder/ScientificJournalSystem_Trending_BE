import { Router } from 'express';
import articlesRoutes from './articles.routes.js';
import analyticsRoutes from './analytics.routes.js';

const router = Router();

/**
 * Mount all feature routes.
 */
router.use('/articles', articlesRoutes);
router.use('/analytics', analyticsRoutes);

export default router;



