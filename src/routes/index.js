import { Router } from 'express';
import articlesRoutes from './articles.routes.js';

const router = Router();

/**
 * Mount all feature routes.
 */
router.use('/articles', articlesRoutes);

export default router;



