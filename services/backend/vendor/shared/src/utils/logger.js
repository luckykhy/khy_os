/**
 * Winston logger with daily file rotation
 * @pattern Decorator
 */
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'khyos' },
  transports: [
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      level: 'info'
    }),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error'
    })
  ]
});

// Console output in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length > 1 ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level}] ${message}${metaStr}`;
      })
    )
  }));
}

module.exports = logger;
