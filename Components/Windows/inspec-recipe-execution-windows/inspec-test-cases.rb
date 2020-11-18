title "Amazon SSM Agent should be installed"
describe package('Amazon SSM Agent') do
  it { should be_installed }
end

title "Amazon SSM Agent service should be installed, enabled and running"
describe service('AmazonSSMAgent') do
  it { should be_installed }
  it { should be_enabled }
  it { should be_running }
end