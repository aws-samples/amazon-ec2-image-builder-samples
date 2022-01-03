title "Amazon SSM Agent should be installed"
describe package('amazon-ssm-agent') do
  it { should be_installed }
end

title "Amazon SSM Agent service should be installed, enabled and running"
describe service('amazon-ssm-agent') do
  it { should be_installed }
  it { should be_enabled }
  it { should be_running }
end