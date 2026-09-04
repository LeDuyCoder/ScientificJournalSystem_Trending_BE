# Sử dụng base image Node.js 22 phiên bản gọn nhẹ (Alpine)
FROM node:22-alpine

# Cài đặt thư viện openssl vì Prisma Query Engine cần nó để chạy trên Alpine Linux
RUN apk add --no-cache openssl

# Cài đặt thư mục làm việc mặc định trong container
WORKDIR /app

# Copy package.json và package-lock.json trước để tận dụng Docker cache layer cho phần install
COPY package.json package-lock.json ./

# Cài đặt các thư viện (Dùng npm install thay cho npm ci để tránh lỗi out-of-sync trên một số môi trường)
RUN npm install

# Copy toàn bộ mã nguồn của dự án vào container (sẽ bỏ qua các file trong .dockerignore)
COPY . .

# Bắt buộc: Khởi tạo Prisma Client để map với Database
RUN npx prisma generate

# Expose port mà Fastify server đang lắng nghe (được cấu hình qua env PORT=3000)
EXPOSE 3000

# Khởi chạy ứng dụng (chạy lệnh "node server.js" đã được định nghĩa trong package.json)
CMD ["npm", "start"]
