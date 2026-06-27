// Hàm lấy thời gian hiện tại theo định dạng chuẩn YYYY-MM-DD HH:mm:ss
const getTimestamp = () => {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
};

const logger = {
  info: (message, ...args) => {
    console.log(`[${getTimestamp()}] [INFO]: ${message}`, ...args);
  },
  
  warn: (message, ...args) => {
    console.warn(`\x1b[33m[${getTimestamp()}] [WARN]: ${message}\x1b[0m`, ...args); 
    // \x1b[33m và \x1b[0m là mã màu giúp chữ WARN có màu vàng trên terminal
  },
  
  error: (message, error = '') => {
    console.error(`\x1b[31m[${getTimestamp()}] [ERROR]: ${message}\x1b[0m`, error.stack || error);
    // Mã màu đỏ cho ERROR và in ra stack trace của lỗi nếu có
  },
  
  db: (message, ...args) => {
    console.log(`\x1b[36m[${getTimestamp()}] [DATABASE]: ${message}\x1b[0m`, ...args);
    // Mã màu xanh ngọc (Cyan) dành riêng cho các log liên quan đến DB
  }
};

export default logger;