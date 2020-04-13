# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Cookbook:: hello-world
# Recipe:: default
#

file '/tmp/created_by_chef.txt' do
    content 'Hello world from Chef!'
    action :create
end