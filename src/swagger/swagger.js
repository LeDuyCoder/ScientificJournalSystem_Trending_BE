import swaggerJSDoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Scientific Journal System API',
      version: '1.0.0',
    },
    servers: [
      {
        url: '/',
      },
    ],
  },
  apis: ['./src/routes/*.js'],
};

/**
 * Generated OpenAPI specification object.
 *
 * @returns {import('swagger-jsdoc').SwaggerDefinition}
 */
export const swaggerSpec = swaggerJSDoc(options);

