# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Cookbook:: hello-world
# Recipe:: default
#

directory 'C:\Temp' do
    action :create
end

file 'C:\Temp\CreatedByChef.txt' do
    content 'Hello world from Chef!'
    action :create
end
