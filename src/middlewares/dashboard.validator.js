import { z } from 'zod';

// Lấy validateQuery từ file validator chung thay vì tự định nghĩa lại
import { validateQuery } from './analytics.validator.js'; 

/**
 * Schema để xác thực các tham số query cho endpoint GET /dashboard/stats.
 *
 * - `project_id`: Là một chuỗi (string) và là tùy chọn (optional).
 *   Nếu có, nó sẽ được trim khoảng trắng thừa.
 */
const getDashboardStatsSchema = z.object({
  project_id: z.string().trim().optional(),
});

/**
 * Middleware được tạo ra từ `getDashboardStatsSchema` để xác thực
 * request query cho handler `getDashboardStatsHandler`.
 *
 * Middleware này sẽ được gắn vào route để đảm bảo dữ liệu đầu vào hợp lệ.
 */
export const validateGetDashboardStats = validateQuery(getDashboardStatsSchema);