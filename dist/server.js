import express from 'express';
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => {
    res.send('Hello World!');
});
app.listen(PORT, () => {
    // Server started on PORT (use proper logger in production)
});
//# sourceMappingURL=server.js.map