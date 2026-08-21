import "@testing-library/jest-dom/vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://template-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_TEMPLATE_TEST_VALUE_123456";
process.env.APP_ORIGIN = "http://127.0.0.1:3000";
process.env.AUTH_SIGNUP_MODE = "disabled";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
