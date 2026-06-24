import { JSONSchema7 } from 'json-schema';

export const databaseSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    host: { type: 'string', default: 'localhost' },
    port: { type: 'integer', minimum: 1, maximum: 65535, default: 5432 },
    user: { type: 'string', default: 'verinode' },
    password: { type: 'string', default: '' },
    database: { type: 'string', default: 'verinode' },
    maxConnections: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    idleTimeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 30000 },
    connectionTimeoutMs: { type: 'integer', minimum: 1000, maximum: 60000, default: 10000 },
  },
  required: ['host', 'port', 'user', 'password', 'database'],
};

export const mtlsSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false },
    certFile: { type: 'string' },
    keyFile: { type: 'string' },
    caFile: { type: 'string' },
    trustDomain: { type: 'string', default: 'cluster.local' },
    allowedSpiffeIds: { 
      type: 'array', 
      items: { type: 'string' },
      default: []
    },
    certMaxValidityMs: { 
      type: 'integer', 
      minimum: 1, 
      maximum: 86400000, 
      default: 86400000 // 24 hours
    },
    minSecondsUntilExpiry: { 
      type: 'integer', 
      minimum: 1, 
      maximum: 86400, 
      default: 3600 
    },
    reloadPollMs: { 
      type: 'integer', 
      minimum: 10000, 
      maximum: 300000, 
      default: 30000 
    },
  },
  required: ['enabled'],
};

export const tlsSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    acme: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: false },
        domains: {
          type: 'array',
          items: { type: 'string' },
          default: []
        },
        email: { type: 'string' },
        directoryUrl: { type: 'string', default: 'https://acme-v02.api.letsencrypt.org/directory' },
        termsOfServiceAgreed: { type: 'boolean', default: false },
        renewBeforeDays: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
        emergencyNotifyDays: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
        checkIntervalMs: { type: 'integer', minimum: 3600000, maximum: 86400000, default: 86400000 },
      },
      required: ['enabled']
    },
    certPath: { type: 'string' },
    keyPath: { type: 'string' },
    chainPath: { type: 'string' },
    webroot: { type: 'string', default: '/tmp/verinode-acme' },
  },
  required: ['certPath', 'keyPath'],
};

export const telemetrySchema: JSONSchema7 = {
  type: 'object',
  properties: {
    otel: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: true },
        endpoint: { type: 'string', format: 'uri', default: 'http://localhost:4317' },
        serviceName: { type: 'string', default: 'verinode-backend' },
        samplingRatio: { type: 'number', minimum: 0, maximum: 1, default: 1.0 },
      },
      required: ['enabled']
    }
  },
  required: ['otel']
};

export const appSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    port: { type: 'integer', minimum: 1, maximum: 65535, default: 3000 },
    environment: { 
      type: 'string', 
      enum: ['development', 'production', 'test'], 
      default: 'development' 
    },
    logLevel: { 
      type: 'string', 
      enum: ['debug', 'info', 'warn', 'error'], 
      default: 'info' 
    },
  },
  required: ['port', 'environment', 'logLevel'],
};

export const stakingSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    maxConcurrentWorkers: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    nonceRangeLimit: { type: 'string', pattern: '^[0-9]+$', default: '1000' },
  },
  required: ['maxConcurrentWorkers', 'nonceRangeLimit'],
};

export const remoteSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    etcd: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: false },
        endpoints: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
          default: ['http://localhost:2379']
        },
        username: { type: 'string' },
        password: { type: 'string' },
        keyPrefix: { type: 'string', default: 'verinode/config' },
        watchIntervalMs: { type: 'integer', minimum: 1000, maximum: 60000, default: 10000 },
      },
      required: ['enabled']
    },
    consul: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: false },
        address: { type: 'string', format: 'hostname' },
        token: { type: 'string' },
        keyPrefix: { type: 'string', default: 'verinode/config' },
        watchIntervalMs: { type: 'integer', minimum: 1000, maximum: 60000, default: 10000 },
      },
      required: ['enabled']
    }
  }
};

export const mainSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'VeriNode Backend Configuration',
  description: 'Centralized configuration schema for VeriNode backend services',
  type: 'object',
  properties: {
    db: databaseSchema,
    mtls: mtlsSchema,
    tls: tlsSchema,
    telemetry: telemetrySchema,
    app: appSchema,
    staking: stakingSchema,
    remote: remoteSchema,
  },
  required: ['db', 'app'],
};
