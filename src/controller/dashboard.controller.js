/**
 * Bộ điều khiển Express (Express controller) cho các endpoint liên quan đến Dashboard.
 */

import { getDashboardStats } from '../services/dashboard.service.js';

/**
 * Endpoint xử lý yêu cầu GET /dashboard/stats
 *
 * Hàm này chịu trách nhiệm:
 * 1. Gọi tầng nghiệp vụ (Service layer) thông qua hàm `getDashboardStats()` để lấy dữ liệu.
 * 2. Phản hồi kết quả về phía Client dưới dạng JSON với mã trạng thái HTTP 200.
 * 3. Nếu xảy ra lỗi trong quá trình lấy dữ liệu, lỗi sẽ được chuyển tiếp sang middleware xử lý lỗi tiếp theo qua hàm `next(err)`.
 *
 * @param {import('express').Request}  req - Đối tượng Request của Express.
 * @param {import('express').Response} res - Đối tượng Response của Express.
 * @param {import('express').NextFunction} next - Hàm chuyển tiếp middleware tiếp theo của Express.
 * @returns {Promise<void>}
 */
export async function getDashboardStatsHandler(req, res, next) {
    try {
        // Gọi service xử lý logic lấy dữ liệu thống kê từ Neo4j / Redis
        const data = await getDashboardStats();

        // Trả về phản hồi thành công kèm dữ liệu thống kê
        res.status(200).json({
            code: 200,
            message: 'Fetch dashboard statistics successfully',
            data,
        });
    } catch (err) {
        // Chuyển tiếp lỗi sang Error Handler Middleware để phản hồi về Client một cách an toàn
        next(err);
    }
}