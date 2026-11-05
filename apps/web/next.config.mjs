/** 정적 파일로 내보내 중앙 서버(NestJS)가 그대로 제공합니다. */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
