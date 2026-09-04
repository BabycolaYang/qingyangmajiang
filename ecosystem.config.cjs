// PM2 进程配置：京东云等云服务器常驻部署用。
// 用法：npm install -g pm2 && pm2 start ecosystem.config.cjs
// 日志：pm2 logs qingyang-majiang
module.exports = {
  apps: [
    {
      name: "qingyang-majiang",
      script: "scripts/online-server.js",
      // 监听 0.0.0.0 才能被公网访问；端口与安全组放行保持一致。
      env: {
        HOST: "0.0.0.0",
        PORT: 4174,
      },
      // 实例异常退出 5 秒后自动拉起。
      restart_delay: 5000,
      // 内存超 300M 自动重启（防慢泄漏）。
      max_memory_restart: "300M",
      // 保留最近日志便于排查联机问题。
      error_file: "logs/majiang-error.log",
      out_file: "logs/majiang-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
