import { Router } from 'express';
import * as controller from '../controller/projectArticle.controller.js';

const router = Router({ mergeParams: true });

router.post('/:project_id/articles/:article_id/bookmark', controller.bookmarkArticle);
router.delete('/:project_id/articles/:article_id/bookmark', controller.unbookmarkArticle);
router.patch('/:project_id/articles/:article_id/bookmark', controller.updateBookmarkNotes);
router.get('/:project_id/bookmarked-articles', controller.getBookmarkedArticles);

export default router;
