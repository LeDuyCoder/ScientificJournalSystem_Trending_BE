import * as projectArticleService from '../services/projectArticle.service.js';
import logger from '../utils/logger.js';

export const bookmarkArticle = async (req, res, next) => {
  try {
    const { project_id, article_id } = req.params;
    const { notes } = req.body;
    const userId = req.user.user_id;

    const result = await projectArticleService.bookmarkArticle(project_id, article_id, userId, notes);
    
    res.status(200).json({
      code: 200,
      message: 'Đánh dấu bài báo thành công',
      data: result
    });
  } catch (error) {
    if (error.code === '23503') { 
      return res.status(404).json({ code: 404, message: 'Bài báo không tồn tại trong hệ thống' });
    }
    logger.error(`Error bookmarking article ${req.params.article_id}:`, error);
    next(error);
  }
};

export const unbookmarkArticle = async (req, res, next) => {
  try {
    const { project_id, article_id } = req.params;
    const userId = req.user.user_id;

    const result = await projectArticleService.unbookmarkArticle(project_id, article_id, userId);
    
    if (!result) {
      return res.status(404).json({ code: 404, message: 'Chưa đánh dấu bài báo này' });
    }

    res.status(200).json({
      code: 200,
      message: 'Bỏ đánh dấu thành công',
      data: result
    });
  } catch (error) {
    logger.error(`Error unbookmarking article ${req.params.article_id}:`, error);
    next(error);
  }
};

export const updateBookmarkNotes = async (req, res, next) => {
  try {
    const { project_id, article_id } = req.params;
    const { notes } = req.body;
    const userId = req.user.user_id;

    const result = await projectArticleService.updateBookmarkNotes(project_id, article_id, userId, notes);
    
    if (!result) {
      return res.status(404).json({ code: 404, message: 'Chưa đánh dấu bài báo này' });
    }

    res.status(200).json({
      code: 200,
      message: 'Cập nhật ghi chú thành công',
      data: result
    });
  } catch (error) {
    logger.error(`Error updating bookmark notes ${req.params.article_id}:`, error);
    next(error);
  }
};

export const getBookmarkedArticles = async (req, res, next) => {
  try {
    const { project_id } = req.params;
    
    const result = await projectArticleService.getBookmarkedArticles(project_id);
    
    res.status(200).json({
      code: 200,
      message: 'Lấy danh sách bài báo đã đánh dấu thành công',
      data: result
    });
  } catch (error) {
    logger.error(`Error getting bookmarked articles for project ${req.params.project_id}:`, error);
    next(error);
  }
};
