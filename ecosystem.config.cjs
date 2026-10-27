// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "universal-agent",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--env-file-if-exists=.env",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: "400M",
      kill_timeout: 100000, // ishlanayotgan javoblarni tugatishga vaqt (agy ~10-20 s)
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
