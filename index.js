
const http = require('http');
const port = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.write('Bot is live!');
  res.end();
}).listen(port, () => {
  console.log(`Server running on port ${port}`);
});