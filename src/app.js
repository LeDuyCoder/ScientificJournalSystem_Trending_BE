import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger/swagger.js';
import indexRoutes from './routes/index.js';
import { errorHandler } from './middlewares/error.middleware.js';

/**
 * Main Express application instance.
 *
 * @type {import('express').Express}
 */
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

app.use(express.json());

// Basic health check & routes
app.use('/', indexRoutes);

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 404
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// Error handling
app.use(errorHandler);

export default app;