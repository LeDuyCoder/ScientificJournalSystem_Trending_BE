import { getDashboardStats } from '../services/dashboard.service.js';

/**
 * Hàm hỗ trợ phân tích query parameter thành mảng các chuỗi/số sạch.
 * @param {any} val - Giá trị query parameter.
 * @returns {Array<string|number>}
 */
function parseFilterArray(val) {
    if (!val) return [];
    const raw = Array.isArray(val)
        ? val
        : String(val).split(',').map(v => v.trim());
    
    return raw
        .map(v => {
            const num = Number(v);
            return !Number.isNaN(num) && String(num) === String(v) ? num : v;
        })
        .filter(v => v !== '');
}

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
        const filters = {
            projectId: req.query.project_id ? String(req.query.project_id).trim() : undefined,
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