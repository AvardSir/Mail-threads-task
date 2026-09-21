// jest.setup.ts — выполняется ДО загрузки тест-файлов
process.env.PROVIDER_URL = 'http://test-provider';
process.env.REQUEST_TIMEOUT = '500';
process.env.MAX_RETRIES = '3';
process.env.BASE_DELAY = '10';        // маленькие задержки вместо фейковых таймеров
process.env.MAX_DELAY = '50';
process.env.TOTAL_OPERATION_TIMEOUT = '10000';
process.env.LOG_LEVEL = 'silent';