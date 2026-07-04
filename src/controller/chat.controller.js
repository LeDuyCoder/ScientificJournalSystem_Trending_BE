import { chatPipeline } from '../services/rag-system.service.js';
import logger from '../utils/logger.js';

export const chatRagSystem = async (req, res) => {
    const requestBody = req.body;
    
    if (!requestBody || !requestBody.message) {
        return res.status(400).json({ 
            success: false, 
            message: 'Message is required' 
        });
    }
    
    try {
        const userQuestion = requestBody.message;
        
        logger.info(`[CHAT API] Nhận yêu cầu: ${userQuestion}`);

        // Gọi pipeline xử lý Chatbot
        const result = await chatPipeline(userQuestion);

        return res.status(200).json({
            success: true,
            routeDecision: result.routeDecision,
            toolResult: result.toolResult,
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