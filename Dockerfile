FROM php:8.3-apache AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq-dev unzip $PHPIZE_DEPS \
    && docker-php-ext-install -j"$(nproc)" pdo_pgsql \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

WORKDIR /build
COPY composer.json composer.lock ./
RUN composer install --no-dev --prefer-dist --no-interaction --no-progress --optimize-autoloader

FROM php:8.3-apache AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 libxml2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/lib/php/extensions/no-debug-non-zts-20230831/pdo_pgsql.so /usr/local/lib/php/extensions/no-debug-non-zts-20230831/
COPY --from=build /usr/local/etc/php/conf.d/docker-php-ext-pdo_pgsql.ini /usr/local/etc/php/conf.d/
COPY --from=build /build/vendor/ /var/www/html/vendor/
COPY api/ /var/www/html/api/
COPY docker/apache-hardening.conf /etc/apache2/conf-available/rayn-api.conf
COPY docker/php-production.ini /usr/local/etc/php/conf.d/zz-production.ini
COPY docker/entrypoint.sh /usr/local/bin/rayn-entrypoint

RUN a2enconf rayn-api \
    && chmod 755 /usr/local/bin/rayn-entrypoint \
    && php -r '$required = ["PDO", "pdo_pgsql", "SimpleXML", "openssl", "json", "pcre", "iconv", "hash"]; foreach ($required as $extension) { if (!extension_loaded($extension)) { fwrite(STDERR, "Missing PHP extension: $extension\n"); exit(1); } } if (!in_array("pgsql", PDO::getAvailableDrivers(), true)) { fwrite(STDERR, "PDO PostgreSQL driver is unavailable\n"); exit(1); }'

WORKDIR /var/www/html
ENV PORT=10000
EXPOSE 10000
CMD ["/usr/local/bin/rayn-entrypoint"]
