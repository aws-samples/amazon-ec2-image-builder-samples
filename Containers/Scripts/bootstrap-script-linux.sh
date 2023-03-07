#!/bin/bash -xe

# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this
# software and associated documentation files (the "Software"), to deal in the Software
# without restriction, including without limitation the rights to use, copy, modify,
# merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
# PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
# HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
# SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# Create working directory if does not exists
if [ ! -d /tmp/imagebuilder_service ]; then
  mkdir -p /tmp/imagebuilder_service;
fi

# Stop ECS service if running
if systemctl --type service | grep -q "ecs"; then
    sudo systemctl stop ecs
fi

function package_exists() {
    $(type "$1" > /dev/null 2>&1 )
    return $?
}

function install_package() {
    if package_exists yum ; then
        yum install -y -q $1
    elif package_exists apt-get ; then
        apt-get update -y -qq
        apt-get install -y -qq $1
    else
        echo "Unable to install package '$1'"
        exit -1
    fi
}
if ! package_exists unzip ; then
    install_package unzip
fi

# Install AWS ClI
if ! package_exists aws ; then
    ARCH=$(uname -m)
    curl "https://awscli.amazonaws.com/awscli-exe-linux-$ARCH.zip" -o "/tmp/imagebuilder_service/awscli.zip"
    sudo unzip -o /tmp/imagebuilder_service/awscli.zip -d /tmp/imagebuilder_service
    /tmp/imagebuilder_service/aws/install
    ln -sf /usr/local/bin/aws /usr/bin/aws
else
    echo "AWS CLI already installed. Skipping install"
fi

# Install dependencies
sudo curl -sSL "https://git.io/get-mo" -o "/tmp/imagebuilder_service/mo"
sudo chmod +x /tmp/imagebuilder_service/mo

# Start Docker
NAME=$(uuidgen)
if ! package_exists docker ; then
    install_package docker
fi
sudo service docker start
output=$(bash -c 'docker ps' '2>&1'); i=0;
    while [[ $output == *'connection reset by peer'* ]];
        do sleep 1; let 'i++';
        if [ $i -eq 600 ]; then
            echo 'Docker failed to start';
            exit 1;
        fi;
    output=$(bash -c 'docker ps' '2>&1');
done

# Install dependencies
cat << 'EOS' > /tmp/imagebuilder_service/container_bootstrap.sh
#!/bin/bash -xe

function package_exists() {
    $(type "$1" > /dev/null 2>&1 )
    return $?
}

function install_package() {
    if package_exists yum ; then
        yum install -y -q $1
    elif package_exists apt-get ; then
        apt-get update -y -qq
        apt-get install -y -qq $1
    else
        echo "Unable to install package '$1'"
        exit -1
    fi
}

if ! package_exists which ; then
    install_package which
fi

if ! package_exists sudo ; then
    install_package sudo
fi

if ! package_exists curl ; then
    install_package curl
fi

EOS

cat << 'EOF' > /tmp/imagebuilder_service/container_cleanup.sh
#!/bin/bash -xe

function package_exists() {
    $(type "$1" > /dev/null 2>&1 )
    return $?
}

function clear_package_cache() {
    if package_exists yum ; then
        yum clean all
        rm -rf /var/cache/yum
    fi

    if package_exists apt-get ; then
        apt-get clean
    fi
}

clear_package_cache

EOF
