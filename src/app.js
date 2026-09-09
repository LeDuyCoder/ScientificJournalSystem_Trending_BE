import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { swaggerSpec } from './swagger/swagger.js';
import indexRoutes from './modules/index.js';


const app = Fastify({
  logger: true
});

const allowedOrigins = [
  process.env.FRONTEND_URL_TRENDING,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175'
].filter(Boolean);

app.register(cors, {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
});
// Hook to sanitize incoming query parameters that are literally "undefined"
app.addHook('preValidation', async (request) => {
  if (request.query) {
    for (const key in request.query) {
      if (request.query[key] === 'undefined' || request.query[key] === 'null') {
        delete request.query[key];
      }
    }
  }
});
// Trả về JSON swaggerSpec cũ
app.get('/api-docs.json', async () => {
  return swaggerSpec;
});

// Đăng ký Swagger & Swagger UI của Fastify
app.register(swagger, {
  mode: 'static',
  specification: {
    document: swaggerSpec
  }
});

app.register(swaggerUi, {
  routePrefix: '/api-docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: false
  },
});

// Health check
app.get('/', async () => {
  return { message: 'Scientific Journal API is running (Fastify)' };
});

// Đăng ký toàn bộ module routes
app.register(indexRoutes);


// Error handling
app.setErrorHandler(function (error, request, reply) {
  const status = error.statusCode || 500;
  reply.status(status).send({
    message: error.message || 'Internal Server Error'
  });
});

export default app;