package com.umbrella.beanstalkd;

import static com.google.common.base.Preconditions.checkNotNull;
import io.netty.bootstrap.Bootstrap;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.ChannelPipeline;
import io.netty.channel.EventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.handler.codec.string.StringDecoder;
import io.netty.handler.codec.string.StringEncoder;

import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.google.common.collect.Lists;

public class Beanstalkd {
	
	private final String host;
	
	private final int port;
	
	private final int timeout;
	
	private final TimeUnit unit;
	
	private BeanstalkdConnection connection;
	
	public Beanstalkd(String host, int port, int timeout, TimeUnit unit) {
		this.host = host;
		this.port = port;
		this.timeout = timeout;
		this.unit = unit;
	}
	
	public String put(String data) throws InterruptedException, ExecutionException, TimeoutException {
		return put((long)(Math.pow(2, 32) -1), 0, 120, data);
	}
	
	public String put(long pri, int delay, int ttr, String data) throws InterruptedException, ExecutionException, TimeoutException {
		long max = (long)(Math.pow(2, 32) -1);
		pri = pri > max ? max : pri;
		return emitToConnection(String.format("put %s %s %s %s\r\n%s\r\n", pri, delay, ttr, data.length(), data), timeout, unit);
	}
	
	public String use(String tube) throws InterruptedException, ExecutionException, TimeoutException {
		return emitToConnection(String.format("use %s\r\n", tube), timeout, unit);
	}
	
	public BeanstalkdJob reserve() throws InterruptedException, ExecutionException {
		String response = emitToConnection("reserve\r\n");
		return response.equals("") ? null : new BeanstalkdJob(response);
	}
	
	public String kick(int bound) throws InterruptedException, ExecutionException, TimeoutException {
		return emitToConnection(String.format("kick %s\r\n", bound), timeout, unit);
	}
	
	public String watch(String tube) throws InterruptedException, ExecutionException, TimeoutException {
		return emitToConnection(String.format("watch %s\r\n", tube), timeout, unit);
	}
	
	public String delete(long id) throws InterruptedException, ExecutionException, TimeoutException {
		return emitToConnection(String.format("delete %s\r\n", id), timeout, unit);
	}
	
	public String release(long id, long pri, int delay) throws InterruptedException, ExecutionException, TimeoutException {
		long max = (long)(Math.pow(2, 32) -1);
		pri = pri > max ? max : pri;
		return emitToConnection(String.format("release %s %s %s\r\n", id, pri, delay), timeout, unit);
	}
	
	public String bury(long id, long pri) throws InterruptedException, ExecutionException, TimeoutException {
		return emitToConnection(String.format("bury %s %s\r\n", id, pri), timeout, unit);
	}
	
	private String emitToConnection(String request) throws InterruptedException, ExecutionException {
		checkNotNull(connection, "connection is null");
		String response =  connection.emit(request);
		if(BAD_RESPONSE.stream().anyMatch(response::equals)){
			throw new IllegalStateException("beanstalkd bad response " + response);
		};
		return response;
	}
	
	private String emitToConnection(String request, int timeout, TimeUnit unit) throws InterruptedException, ExecutionException, TimeoutException {
		checkNotNull(connection, "connection is null");
		String response =  connection.emit(request, timeout, unit);
		if(BAD_RESPONSE.stream().anyMatch(response::equals)){
			throw new IllegalStateException("beanstalkd bad response " + response);
		};
		return response;
	}
	
	public void connect(EventLoopGroup group, Class<? extends SocketChannel> channelClass) throws InterruptedException {
		new Bootstrap().group(group).channel(channelClass)
				.handler(new ChannelInitializer<SocketChannel>() {
					@Override
					protected void initChannel(SocketChannel ch) throws Exception {
						ChannelPipeline p = ch.pipeline();
						connection = new BeanstalkdConnection();
						p.addLast(new StringEncoder(), new StringDecoder(), connection);
					}
				}).connect(host, port).sync();
	}
	
	public void close() {
		if(connection != null) connection.close();
	}
	
	public boolean isConnected() {
		if(connection != null) return connection.isConnected();
		return false;
	}
	
	private static final List<String> BAD_RESPONSE = Lists.newArrayList(
		"OUT_OF_MEMORY\r\n",
		"INTERNAL_ERROR\r\n",
		"BAD_FORMAT\r\n",
		"UNKNOWN_COMMAND\r\n"
	);
}
