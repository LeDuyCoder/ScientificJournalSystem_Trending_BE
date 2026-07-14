import { getDashboardStats } from '../services/dashboard.service.js';

/**
 * Endpoint xử lý yêu cầu GET /dashboard/stats
 *
 * @param {import('express').Request}  req - Đối tượng Request của Express.
 * @param {import('express').Response} res - Đối tượng Response của Express.
 * @param {import('express').NextFunction} next - Hàm chuyển tiếp middleware tiếp theo của Express.
 * @returns {Promise<void>}
 */
export async function getDashboardStatsHandler(req, res, next) {
    try {
        const { project_id } = req.validatedQuery;

        const filters = {
            projectId: project_id,
        };

        // Gọi service xử lý logic lấy dữ liệu thống kê từ Neo4j / Redis với bộ lọc
        const data = await getDashboardStats(filters);

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