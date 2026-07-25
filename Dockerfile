# Static microservice: nginx serves the client-side converter.
# No build step, no runtime dependencies.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY src /usr/share/nginx/html/src

EXPOSE 80
