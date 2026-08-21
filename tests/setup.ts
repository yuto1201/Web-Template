import "@testing-library/jest-dom/vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://template-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_TEMPLATE_TEST_VALUE_123456";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
