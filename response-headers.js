const headerTemplate = {
  notFound: (contentType, content) => {
    return `HTTP/1.1 404 Not Found\r
Content-Type: ${contentType}; charset=UTF-8\r
Connection: close\r\n\r\n${content}`
  }
}

module.exports = {
  plainText: `HTTP/1.1 200 OK\r
Content-Type: text/plain; charset=UTF-8\r
Connection: close\r\n\r\n`,
  html: `HTTP/1.1 200 OK\r
Content-Type: text/html; charset=UTF-8\r
Connection: close\r\n\r\n`,
  notFound: `HTTP/1.1 404 Not Found\r
Content-Length: 0\r
Connection: close\r\n\r\n`,
  notFoundWithText: text => headerTemplate.notFound("text/plain", text)
}