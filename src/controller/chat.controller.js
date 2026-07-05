import { chatPipeline } from '../services/rag-system.service.js';
import logger from '../utils/logger.js';

export const chatRagSystem = async (req, res) => {
    const requestBody = req.body;
    const projectId = requestBody ? (requestBody.project_id || requestBody.projectId) : null;
    
    if (!requestBody || !requestBody.message) {
        return res.status(400).json({ 
            success: false, 
            message: 'Message is required' 
        });
    }
    
    if (!projectId) {
        return res.status(400).json({
            success: false,
            message: 'project_id (or projectId) is required'
        });
    }
    
    try {
        const userQuestion = requestBody.message;
        
        logger.info(`[CHAT API] Nhận yêu cầu: ${userQuestion} (Project ID: ${projectId})`);

        // Gọi pipeline xử lý Chatbot
        const result = await chatPipeline(userQuestion, projectId);

        return res.status(200).json({
            success: true,
            answer: result.answer
        });
        
    } catch (error) {
        logger.error('[CHAT API] Lỗi xử lý yêu cầu Chatbot:', error);
        return res.status(500).json({ 
            success: false, 
            message: 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau.' 
        });
    }
};