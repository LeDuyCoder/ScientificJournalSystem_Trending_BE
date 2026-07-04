export const cleanGeneratedSql = (rawResponse) => {
    const raw = rawResponse.trim();
    if (raw.toUpperCase().includes("CANNOT_GENERATE_SQL")) {
        throw new Error("Không thể tạo câu lệnh SQL dựa trên cấu trúc hiện tại.");
    }
    
    // Loại bỏ markdown blocks ```sql ... ``` và ``` ... ```
    let sql = raw.replace(/```sql/gi, "").replace(/```/g, "").trim();
    
    // Bắt đầu lấy từ từ khóa SELECT đầu tiên
    const selectMatch = sql.match(/SELECT[\s\S]*/i);
    if (!selectMatch) {
        throw new Error("AI trả về câu lệnh không hợp lệ hoặc thiếu SELECT.");
    }
    
    sql = selectMatch[0].trim();
    
    // Bỏ dấu chấm phẩy ; ở cuối câu truy vấn để tránh chạy nhiều lệnh
    if (sql.includes(";")) {
        sql = sql.split(";")[0].trim();
    }
    
    return sql;
};

export const validateSql = (sql) => {
    const normalized = sql.toLowerCase().trim();
    
    // Chỉ chấp nhận đọc dữ liệu SELECT
    if (!normalized.startsWith("select")) {
        throw new Error("Chỉ chấp nhận câu lệnh SELECT đọc dữ liệu.");
    }
    
    // Chặn dấu chấm phẩy lồng câu lệnh độc lập
    if (sql.replace(/;$/, "").includes(";")) {
        throw new Error("Không được phép chạy nhiều câu lệnh SQL cùng lúc.");
    }
    
    // Danh sách từ khóa cấm
    const forbiddenKeywords = ["insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke"];
    for (const keyword of forbiddenKeywords) {
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(normalized)) {
            throw new Error(`Phát hiện từ khóa nguy hiểm bị cấm thực thi: ${keyword}`);
        }
    }
    
    return true;
};
