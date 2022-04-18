# WordPress EC2 Image Builder Components

>NOTE: These samples are not intended for production use and are provided to demonstrate how WordPress could be installed using EC2 Image Builder. These samples do not implement the best practices guidance for deploying WordPress on AWS (such as ensuring SSL is configured).

This folder contains sample components that demonstrate how WordPress can be baked into an AMI using EC2 Image Builder. 

The components in this sample are designed to be built using Amazon Linux 2. They require the `yum` package manager. 

For more details and best practices for hosting WordPress on AWS, please refer to the [WordPress: Best Practices on AWS blog post](https://aws.amazon.com/blogs/architecture/wordpress-best-practices-on-aws/), the [WordPress: Best Practices on AWS whitepaper](https://d1.awsstatic.com/whitepapers/wordpress-best-practices-on-aws.pdf), or the [reference architecture](https://github.com/aws-samples/aws-refarch-wordpress) for deploying WordPress on AWS.

## Components

### install_wordpress.yml

1. Assumes php 7.4 is/will be pre-installed (eg from the Amazon-managed `php-7-4-linux` EC2 Image Builder component)
2. The latest WordPress is installed from [the official WordPress site](http://wordpress.org/latest.tar.gz).
3. File permissions and owners are set as per the [documentation](https://wordpress.org/support/article/hardening-wordpress/).
4. A .htaccess file is added to the `wp-admin` root to enforce [Basic Auth](https://en.wikipedia.org/wiki/Basic_access_authentication) as an additional security layer. The username and password for this login are written to a file in the `ec2-user` home directory and set to be readable only by that user.
5. The downloaded install file is deleted.

### install_wordpress_with_db.yml

Has the WordPress install code plus:

1. Assumes the MySQL-compatible MariaDB is/will be installed locally on the instance (eg via the latest Amazon-managed `mariadb-linux` Image Builder component). 
2. A strong root user password is generated and set (by default it ships with an empty password) and remote connections to the root account are disabled. 
3. The db root password is written to a file in the `ec2-user` home directory and set to be readable only by that user. *NB: you may never need the root password if you only plan to use the database for WordPress on this instance.*
4. A `wordpress` database is created with a matching `wordpress` database user who is granted limited permissions on that database only. 
5. The connection details including the created db name, user and password are written into a `wp-config.php` file, which simplifies the already simple standard WordPress setup process.

### install_wordpress_with_db_pma.yml

Has the WordPress and Database install code plus:

1. `phpMyAdmin` is downloaded from the [official download site](https://www.phpmyadmin.net/downloads/phpMyAdmin-latest-all-languages.tar.gz)
2. The contents are installed into a directory under the web root called `pma-ui`.
3. File permissions and owners are set as per the [documentation](https://docs.phpmyadmin.net/en/latest/setup.html#securing-your-phpmyadmin-installation).
4. A .htaccess file is added to the `pma-ui` root to enforce [Basic Auth](https://en.wikipedia.org/wiki/Basic_access_authentication) as an additional security layer. The username and password for this login are written to a file in the `ec2-user` home directory and set to be readable only by that user.
5. The downloaded install file is deleted.

phpMyAdmin will be available at `<yourhost>/pma-ui`. 

## User-facing instructions

To use an AMI produced by one of the pipelines in this project you need to create an EC2 instance from the AMI. You will need to configure the instance as you would any other web facing instance. Ensure it has a suitable instance role (eg `AmazonSSMRoleForInstancesQuickSetup` if you want to be able to connect using Systems Manager) and security groups to enable necessary access. 

### Keeping WordPress up-to-date

Note also that while the latest version of WordPress is installed when the AMI is built, you will need to keep WordPress and its plugins and themes up-to-date once you spin up an instance from it. 

If you spin up new WordPress instances regularly that you schedule the EC2 Image Builder pipeline to regularly rebuild the AMI so it does not drift too far from the most recent version.

## License 

See [LICENSE.txt](LICENSE.txt)